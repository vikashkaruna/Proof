import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import {
  UserRole,
  encodePublicWebsiteAssetRequest,
  PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
  PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
} from '@axiom/types';
import type { Variables } from '../types.js';
import { assetSha256 } from '../services/public-website-assets.js';
import { publicWebsiteAssetRoutes } from './public-website-assets.js';
const defaults = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@axiom/supabase', () => ({
  createSupabaseAdmin: () => ({
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: (signal: AbortSignal) => defaults.rpc(name, args, signal),
    }),
  }),
  createHumanActionWriter: () => ({
    rpc: (name: string, args: Record<string, unknown>) => ({
      abortSignal: (signal: AbortSignal) => defaults.rpc(name, args, signal),
    }),
  }),
}));
const tenant = '11111111-1111-4111-8111-111111111111',
  actor = '22222222-2222-4222-8222-222222222222',
  key = '33333333-3333-4333-8333-333333333333',
  id = '44444444-4444-4444-8444-444444444444';
const request = {
  version: 1,
  kind: 'register_target',
  operationKey: key,
  confirmed: true,
  estateId: id,
  systemId: key,
  expectedEstateVersion: 1,
  expectedSystemVersion: 2,
  url: 'https://example.com/',
};
function receipt() {
  const requestText = encodePublicWebsiteAssetRequest(request);
  const snapshot = {
    version: 1,
    kind: 'target',
    id,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    estateId: id,
    systemId: key,
    estateVersion: 1,
    systemVersion: 2,
    targetVersion: 1,
    estateName: 'Estate',
    systemName: 'Public site',
    url: 'https://example.com/',
  };
  const snapshotText = JSON.stringify(snapshot, Object.keys(snapshot).sort());
  return {
    state: 'recorded',
    tenantId: tenant,
    actorId: actor,
    operationKey: key,
    kind: 'register_target',
    requestCodec: PUBLIC_WEBSITE_ASSET_REQUEST_CODEC,
    requestText,
    requestSha256: assetSha256(requestText),
    snapshotCodec: PUBLIC_WEBSITE_ASSET_SNAPSHOT_CODEC,
    snapshotText,
    snapshotSha256: assetSha256(snapshotText),
    receipt: { id: '10', entryHash: 'a'.repeat(64) },
    replayed: false,
  };
}
function setup(role: UserRole = UserRole.OWNER) {
  const read = vi.fn().mockResolvedValue({ data: { state: 'not_found' }, error: null });
  const write = vi.fn().mockResolvedValue({ data: receipt(), error: null });
  const capture = vi.fn();
  const app = new Hono<{ Variables: Variables }>();
  app.use('*', async (c, next) => {
    c.set('tenantId', tenant);
    c.set('user', { id: actor } as never);
    c.set('role', role);
    await next();
  });
  app.route('/v1', publicWebsiteAssetRoutes({ read, write, capture }));
  const send = (body: unknown = request, expected: string | undefined = actor) =>
    app.request('/v1/public-website-assets/operations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(expected ? { 'X-Expected-Actor-Id': expected } : {}),
      },
      body: JSON.stringify(body),
    });
  return { app, read, write, capture, send };
}
it('uses exact canonical request and trusted tenant/actor only on narrow writer', async () => {
  const t = setup();
  expect((await t.send()).status).toBe(201);
  expect(t.write).toHaveBeenCalledWith(
    'record_public_website_asset_operation',
    {
      p_tenant_id: tenant,
      p_actor_id: actor,
      p_request_text: encodePublicWebsiteAssetRequest(request),
    },
    expect.any(AbortSignal),
  );
  expect(t.read).not.toHaveBeenCalled();
  expect(t.capture).not.toHaveBeenCalled();
});
it.each(['invalid', id])(
  'refuses malformed/wrong expected actor %s before any RPC',
  async (expected) => {
    const t = setup();
    expect((await t.send(request, expected)).status).toBe(409);
    expect(t.write).not.toHaveBeenCalled();
    expect(t.read).not.toHaveBeenCalled();
  },
);
it('refuses missing expected actor with zero transport', async () => {
  const t = setup();
  const response = await t.app.request('/v1/public-website-assets/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(409);
  expect(t.write).not.toHaveBeenCalled();
});
it.each([UserRole.VIEWER, UserRole.AXIOM_ANALYST, UserRole.APPROVER])(
  'does not grant %s registration rights',
  async (role) => {
    const t = setup(role);
    expect((await t.send()).status).toBe(403);
    expect(t.write).not.toHaveBeenCalled();
  },
);
it.each([
  'https://user:password@example.com/',
  'https://example.com/?token=secret',
  'http://127.0.0.1/',
])('refuses unsafe/secret-bearing metadata URL before RPC %s', async (url) => {
  const t = setup();
  expect((await t.send({ ...request, url })).status).toBe(400);
  expect(t.write).not.toHaveBeenCalled();
});
it('rejects coherently hashed response from wrong scope', async () => {
  const t = setup();
  t.write.mockResolvedValue({ data: { ...receipt(), tenantId: id }, error: null });
  expect((await t.send()).status).toBe(503);
});
it('does not fetch for capture recovery unknown/read failure or wrong target binding', async () => {
  for (const data of [
    null,
    { state: 'unavailable' },
    { snapshotText: '{}', snapshotSha256: 'a'.repeat(64) },
  ]) {
    const t = setup();
    t.read.mockResolvedValue({ data, error: null });
    expect(
      (
        await t.send({
          version: 1,
          kind: 'capture',
          confirmed: true,
          operationKey: key,
          targetId: id,
          expectedTargetSha256: 'a'.repeat(64),
        })
      ).status,
    ).toBe(503);
    expect(t.capture).not.toHaveBeenCalled();
    expect(t.write).not.toHaveBeenCalled();
  }
});
it('not_found readback stays explicit and never writes', async () => {
  const t = setup();
  const response = await t.app.request(`/v1/public-website-assets/operations/${key}`);
  expect(await response.json()).toEqual({ data: { state: 'not_found' } });
  expect(t.write).not.toHaveBeenCalled();
});
it('uses current target before same existing collector and never fetches after target mismatch', async () => {
  const t = setup();
  t.read
    .mockResolvedValueOnce({ data: { state: 'not_found' }, error: null })
    .mockResolvedValueOnce({
      data: { snapshotText: receipt().snapshotText, snapshotSha256: receipt().snapshotSha256 },
      error: null,
    });
  expect(
    (
      await t.send({
        version: 1,
        kind: 'capture',
        confirmed: true,
        operationKey: key,
        targetId: key,
        expectedTargetSha256: receipt().snapshotSha256,
      })
    ).status,
  ).toBe(503);
  expect(t.capture).not.toHaveBeenCalled();
  expect(t.write).not.toHaveBeenCalled();
});
it('validates target and budget before a bounded fresh capture, then atomically records its association', async () => {
  const t = setup();
  const target = receipt();
  const captureRequest = {
    version: 1,
    kind: 'capture',
    confirmed: true,
    operationKey: key,
    targetId: id,
    expectedTargetSha256: target.snapshotSha256,
  };
  const { encodePublicEvidencePayloadV2 } =
    await import('../connectors/public-evidence-codec-v2.js');
  const pages = (['root', 'privacy', 'contact', 'terms', 'consent'] as const).map((page) => ({
    page,
    state: page === 'root' ? ('examined' as const) : ('unexamined' as const),
    ...(page === 'root' ? { contentSha256: 'a'.repeat(64) } : {}),
    truncated: false,
    coverageReasons: [],
  }));
  const encoded = encodePublicEvidencePayloadV2({
    version: 2,
    extractorVersion: 'public-static-evidence-1',
    scope: 'bounded_public_pages',
    requiresHumanReview: true,
    pages,
    candidates: [],
    candidatesTruncated: false,
  });
  const captured = {
    check: {
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      checkedAt: '2026-10-16T00:00:00.000Z',
      status: 'checked',
      httpStatus: 200,
      bytes: 32,
      contentSha256: 'a'.repeat(64),
      title: 'Public page',
      headings: [],
      publicLinks: [],
      auditPages: [],
      observations: [],
    },
    evidence: {
      codec: encoded.codec,
      payloadText: encoded.payloadText,
      payloadSha256: encoded.payloadSha256,
      pageSources: pages.map((p) => ({
        page: p.page,
        state: p.state,
        contentSha256: p.contentSha256 ?? null,
        requestedUrl: p.page === 'root' ? 'https://example.com/' : null,
        finalUrl: p.page === 'root' ? 'https://example.com/' : null,
      })),
    },
  };
  t.capture.mockResolvedValue(captured);
  t.read
    .mockResolvedValueOnce({ data: { state: 'not_found' }, error: null })
    .mockResolvedValueOnce({
      data: { snapshotText: target.snapshotText, snapshotSha256: target.snapshotSha256 },
      error: null,
    })
    .mockResolvedValueOnce({ data: { allowed: true, retry_after: 1 }, error: null });
  const requestText = encodePublicWebsiteAssetRequest(captureRequest);
  const snapshot = {
    version: 1,
    id: key,
    tenantId: tenant,
    actorId: actor,
    ownershipVerified: false,
    connectorAccessGranted: false,
    kind: 'association',
    targetId: id,
    targetSha256: target.snapshotSha256,
    checkId: id,
    payloadSha256: encoded.payloadSha256,
    captureReceipt: { id: '11', entryHash: 'b'.repeat(64) },
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    checkedAt: '2026-10-16T00:00:00Z',
  };
  const canonical = (o: unknown): string =>
    o !== null && typeof o === 'object' && !Array.isArray(o)
      ? '{' +
        Object.entries(o)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
          .join(',') +
        '}'
      : JSON.stringify(o);
  const snapshotText = canonical(snapshot);
  const positive = {
    ...target,
    kind: 'capture',
    requestText,
    requestSha256: assetSha256(requestText),
    snapshotText,
    snapshotSha256: assetSha256(snapshotText),
  };
  t.write.mockResolvedValue({ data: positive, error: null });
  expect((await t.send(captureRequest)).status).toBe(201);
  expect(t.capture).toHaveBeenCalledWith('https://example.com/', expect.any(AbortSignal));
  expect(t.write).toHaveBeenCalledWith(
    'record_targeted_public_website_capture',
    expect.objectContaining({
      p_request_text: requestText,
      p_payload_sha256: encoded.payloadSha256,
    }),
    expect.any(AbortSignal),
  );
  // Exact positive retry returns the retained association without refetching.
  t.capture.mockClear();
  t.write.mockClear();
  t.read.mockResolvedValueOnce({ data: { ...positive, replayed: true }, error: null });
  expect((await t.send(captureRequest)).status).toBe(200);
  expect(t.capture).not.toHaveBeenCalled();
  expect(t.write).not.toHaveBeenCalled();
});
it('rejects escaped duplicate request keys before any transport', async () => {
  const t = setup();
  const body = JSON.stringify(request).replace(
    '"confirmed":true',
    '"confirmed":false,"confir\\u006ded":true',
  );
  const response = await t.app.request('/v1/public-website-assets/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Expected-Actor-Id': actor },
    body,
  });
  expect(response.status).toBe(400);
  expect(t.read).not.toHaveBeenCalled();
  expect(t.write).not.toHaveBeenCalled();
});
it('fails closed for invalid and unavailable positive readback, scope and permission', async () => {
  const t = setup();
  expect((await t.app.request('/v1/public-website-assets/operations/not-a-uuid')).status).toBe(400);
  expect(t.read).not.toHaveBeenCalled();
  t.read.mockResolvedValueOnce({ data: { ...receipt(), tenantId: id }, error: null });
  expect((await t.app.request(`/v1/public-website-assets/operations/${key}`)).status).toBe(503);
  const agent = setup(UserRole.AGENT);
  expect((await agent.app.request(`/v1/public-website-assets/operations/${key}`)).status).toBe(403);
  expect(agent.read).not.toHaveBeenCalled();
});
it.each([
  'budget_refused',
  'budget_invalid',
  'budget_error',
  'collector_refused',
  'invalid_capture',
])('keeps capture %s fail-closed without a successful receipt', async (scenario) => {
  const t = setup();
  const target = receipt();
  const captureRequest = {
    version: 1,
    kind: 'capture',
    confirmed: true,
    operationKey: key,
    targetId: id,
    expectedTargetSha256: target.snapshotSha256,
  };
  t.read
    .mockResolvedValueOnce({ data: { state: 'not_found' }, error: null })
    .mockResolvedValueOnce({
      data: { snapshotText: target.snapshotText, snapshotSha256: target.snapshotSha256 },
      error: null,
    })
    .mockResolvedValueOnce(
      scenario === 'budget_error'
        ? { data: null, error: {} }
        : scenario === 'budget_invalid'
          ? { data: { allowed: true }, error: null }
          : { data: { allowed: scenario !== 'budget_refused', retry_after: 5 }, error: null },
    );
  if (scenario === 'collector_refused') {
    const { PublicWebsiteRefused } = await import('../connectors/public-website.js');
    t.capture.mockRejectedValue(new PublicWebsiteRefused('non_public_target'));
  } else
    t.capture.mockResolvedValue({ check: { requestedUrl: 'https://wrong.org/' }, evidence: {} });
  const response = await t.send(captureRequest);
  expect(response.status).toBe(
    scenario === 'budget_refused' ? 429 : scenario === 'collector_refused' ? 422 : 503,
  );
  expect(t.write).not.toHaveBeenCalled();
  if (scenario.startsWith('budget')) expect(t.capture).not.toHaveBeenCalled();
});
it('returns503 for failed metadata write, never inventing a receipt', async () => {
  const t = setup();
  t.write.mockResolvedValue({ data: null, error: { message: 'private backend detail' } });
  const response = await t.send();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private backend detail');
});

it('default transport adapters retain scoped arguments and the request abort signal', async () => {
  const t = setup();
  t.app.route('/native', publicWebsiteAssetRoutes());
  defaults.rpc.mockResolvedValue({ data: receipt(), error: null });
  const response = await t.app.request('/native/public-website-assets/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Expected-Actor-Id': actor },
    body: JSON.stringify(request),
  });
  expect(response.status).toBe(201);
  expect(defaults.rpc).toHaveBeenCalledWith(
    'record_public_website_asset_operation',
    expect.objectContaining({ p_tenant_id: tenant, p_actor_id: actor }),
    expect.any(AbortSignal),
  );
  defaults.rpc.mockResolvedValue({ data: { ...receipt(), replayed: true }, error: null });
  expect((await t.app.request(`/native/public-website-assets/operations/${key}`)).status).toBe(200);
  expect(defaults.rpc).toHaveBeenCalledWith(
    'read_public_website_asset_operation',
    expect.objectContaining({ p_operation_key: key }),
    expect.any(AbortSignal),
  );
});
it('rejects invalid UTF8 bytes rather than recording replacement characters', async () => {
  const t = setup();
  const prefix = new TextEncoder().encode(
    JSON.stringify(request).replace('https://example.com/', 'https://example.com/PLACEHOLDER'),
  );
  const at = new TextDecoder().decode(prefix).indexOf('PLACEHOLDER');
  const body = new Uint8Array(prefix.length - 11 + 2);
  body.set(prefix.slice(0, at));
  body.set([0xc3, 0x28], at);
  body.set(prefix.slice(at + 11), at + 2);
  const response = await t.app.request('/v1/public-website-assets/operations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Expected-Actor-Id': actor },
    body,
  });
  expect(response.status).toBe(400);
  expect(t.read).not.toHaveBeenCalled();
  expect(t.write).not.toHaveBeenCalled();
});
