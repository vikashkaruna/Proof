import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import { dpbReportRoutes } from './dpb-reports.js';
import { technicalReportRoutes } from './technical-reports.js';
import { EvidenceError } from '../services/evidence-ingestion.js';
import type { Variables } from '../types.js';

// DPB and technical review packs expose the same governed route surface. The
// route layer must never turn a storage fault into a success body, must keep
// generation/release off read-only roles, and must reject malformed ids and
// operation keys before any service is touched.
const tenantId = randomUUID();
const actorId = randomUUID();
const id = randomUUID();
const operationKey = randomUUID();

type Fakes = { service: Record<string, unknown>; artifacts: Record<string, unknown> };
const variants = [
  { name: 'dpb', prefix: '/v1/reports/dpb', routes: dpbReportRoutes },
  { name: 'technical', prefix: '/v1/reports/technical', routes: technicalReportRoutes },
] as const;

function app(variant: (typeof variants)[number], role: UserRole, fakes: Partial<Fakes>) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('user', { id: actorId } as never);
    c.set('role', role);
    await next();
  });
  instance.route(
    '/v1',
    variant.routes({
      service: (fakes.service ?? {}) as never,
      artifacts: (fakes.artifacts ?? {}) as never,
    }),
  );
  return instance;
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe.each(variants)('$name review-pack route surface', (variant) => {
  it('lists requests with bounded paging and never caches', async () => {
    const listRequests = vi.fn(async () => ({ requests: [], total: 0 }));
    const founder = app(variant, UserRole.FOUNDER, { service: { listRequests } });
    const ok = await founder.request(`${variant.prefix}/requests?limit=10&offset=20`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('private, no-store');
    expect(listRequests).toHaveBeenCalledWith(tenantId, actorId, 10, 20, expect.any(AbortSignal));
    for (const query of ['limit=0', 'limit=51', 'offset=-1', 'offset=10001', 'limit=abc']) {
      const bad = await founder.request(`${variant.prefix}/requests?${query}`);
      expect(bad.status, query).toBe(400);
    }
    expect(listRequests).toHaveBeenCalledTimes(1);
  });

  it('maps a typed evidence error to its status and any other fault to 503 without leaking detail', async () => {
    const listRequests = vi
      .fn()
      .mockRejectedValueOnce(new EvidenceError('report_not_found', 404))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.9:5432 secret-host'));
    const founder = app(variant, UserRole.FOUNDER, { service: { listRequests } });
    const typed = await founder.request(`${variant.prefix}/requests`);
    expect(typed.status).toBe(404);
    expect(await typed.json()).toEqual({ error: { code: 'report_not_found' } });
    const untyped = await founder.request(`${variant.prefix}/requests`);
    expect(untyped.status).toBe(503);
    const text = await untyped.text();
    expect(text).toBe(JSON.stringify({ error: { code: 'report_storage_unavailable' } }));
    expect(text).not.toContain('secret-host');
  });

  it('refuses generation to read-only roles and malformed ids before calling the service', async () => {
    const draft = vi.fn(async () => ({ status: 'drafted' }));
    const viewer = app(variant, UserRole.VIEWER, { service: { draft } });
    expect(
      (await viewer.request(`${variant.prefix}/requests/${id}/generate`, post({}))).status,
    ).toBe(403);
    const founder = app(variant, UserRole.FOUNDER, { service: { draft } });
    expect(
      (await founder.request(`${variant.prefix}/requests/not-a-uuid/generate`, post({}))).status,
    ).toBe(400);
    expect(draft).not.toHaveBeenCalled();
    const ok = await founder.request(`${variant.prefix}/requests/${id}/generate`, post({}));
    expect(ok.status).toBe(200);
    expect(draft).toHaveBeenCalledWith(tenantId, actorId, id, expect.any(AbortSignal));
  });

  it('serves frozen source and artifact status only for valid ids', async () => {
    const source = vi.fn(async () => ({ frozen: true }));
    const status = vi.fn(async () => ({ status: 'pending' }));
    const founder = app(variant, UserRole.FOUNDER, {
      service: { source },
      artifacts: { status },
    });
    expect((await founder.request(`${variant.prefix}/requests/${id}/source`)).status).toBe(200);
    expect((await founder.request(`${variant.prefix}/requests/x/source`)).status).toBe(400);
    expect((await founder.request(`${variant.prefix}/${id}/artifacts/status`)).status).toBe(200);
    expect((await founder.request(`${variant.prefix}/x/artifacts/status`)).status).toBe(400);
    expect(source).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('answers 202 until artifacts settle and 200 only when settled, for build, reconcile and retry', async () => {
    const settled = vi.fn(async () => ({ status: 'settled' }));
    const pending = vi.fn(async () => ({ status: 'pending' }));
    const founder = app(variant, UserRole.FOUNDER, {
      artifacts: { build: pending, reconcile: settled, retryMissing: pending },
    });
    expect(
      (await founder.request(`${variant.prefix}/${id}/artifacts`, post({ operationKey }))).status,
    ).toBe(202);
    expect(
      (await founder.request(`${variant.prefix}/${id}/artifacts/reconcile`, post({ operationKey })))
        .status,
    ).toBe(200);
    expect(
      (
        await founder.request(
          `${variant.prefix}/${id}/artifacts/retry-missing`,
          post({ operationKey }),
        )
      ).status,
    ).toBe(202);
    // The operation key is mandatory, strictly UUID, and no extra fields are accepted.
    for (const body of [{}, { operationKey: 'nope' }, { operationKey, extra: 1 }, null]) {
      const bad = await founder.request(`${variant.prefix}/${id}/artifacts`, post(body));
      expect(bad.status, JSON.stringify(body)).toBe(400);
    }
    expect(pending).toHaveBeenCalledTimes(2);
  });

  it('keeps release and artifact bytes behind validated hashes and capabilities', async () => {
    const release = vi.fn(async () => ({ status: 'published' }));
    const pdf = vi.fn(async () => {
      throw new EvidenceError('artifact_missing', 409);
    });
    const founder = app(variant, UserRole.FOUNDER, { service: { release }, artifacts: { pdf } });
    const hashes = { contentHash: 'a'.repeat(64), pdfHash: 'b'.repeat(64) };
    const bad = await founder.request(
      `${variant.prefix}/${id}/release`,
      post({ ...hashes, pdfHash: 'B'.repeat(64) }),
    );
    expect(bad.status).toBe(400);
    expect(release).not.toHaveBeenCalled();
    const manager = app(variant, UserRole.VIEWER, { service: { release } });
    expect((await manager.request(`${variant.prefix}/${id}/release`, post(hashes))).status).toBe(
      403,
    );
    expect((await founder.request(`${variant.prefix}/${id}/release`, post(hashes))).status).toBe(
      200,
    );
    expect(release).toHaveBeenCalledTimes(1);
    const missing = await founder.request(`${variant.prefix}/${id}/pdf`);
    expect(missing.status).toBe(409);
    expect((await founder.request(`${variant.prefix}/bad/pdf`)).status).toBe(400);
  });
});
