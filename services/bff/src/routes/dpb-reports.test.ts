import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import { dpbReportRoutes } from './dpb-reports.js';
import type { DpbReportService } from '../services/dpb-reports.js';
import type { DpbArtifactService } from '../services/dpb-artifacts.js';
import type { Variables } from '../types.js';

const tenantId = randomUUID();
const actorId = randomUUID();
const reportId = randomUUID();
const operationKey = randomUUID();
const requestId = randomUUID();
function app(
  role: UserRole,
  service: Partial<DpbReportService>,
  artifacts: Partial<DpbArtifactService>,
) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('user', { id: actorId } as never);
    c.set('role', role);
    await next();
  });
  instance.route(
    '/v1',
    dpbReportRoutes({
      service: service as DpbReportService,
      artifacts: artifacts as DpbArtifactService,
    }),
  );
  return instance;
}

describe('DPB source-bound routes', () => {
  it('refuses viewer creation and caller-authored claims', async () => {
    const request = vi.fn();
    const viewer = app(UserRole.VIEWER, { request }, {});
    const body = { breachId: randomUUID(), notificationId: randomUUID(), title: 'Review pack' };
    const denied = await viewer.request('/v1/reports/dpb/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(denied.status).toBe(403);
    const manager = app(UserRole.OWNER, { request }, {});
    const invalid = await manager.request('/v1/reports/dpb/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, regulatorAccepted: true }),
    });
    expect(invalid.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it('routes source request and founder-only retained build without arbitrary content', async () => {
    const request = vi.fn(async () => ({
      requestId,
      reportId: null,
      status: 'requested',
      replayed: false,
    }));
    const build = vi.fn(async () => ({
      reportId,
      buildId: randomUUID(),
      operationKey,
      status: 'pending',
    }));
    const owner = app(UserRole.OWNER, { request }, { build });
    const body = { breachId: randomUUID(), notificationId: randomUUID(), title: 'Review pack' };
    const created = await owner.request('/v1/reports/dpb/request', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    expect(request).toHaveBeenCalledWith(tenantId, actorId, body, expect.any(AbortSignal));
    const pending = await owner.request(`/v1/reports/dpb/${reportId}/artifacts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationKey }),
    });
    expect(pending.status).toBe(202);
    expect(build).toHaveBeenCalledWith(
      tenantId,
      actorId,
      reportId,
      operationKey,
      expect.any(AbortSignal),
    );
  });

  it('keeps release on founder capability and returns only retained PDF bytes', async () => {
    const release = vi.fn(async () => ({
      reportId,
      status: 'published' as const,
      replayed: false,
    }));
    const pdf = vi.fn(async () => ({
      pdfBuffer: Buffer.from('%PDF-fixture'),
      sha256: 'a'.repeat(64),
      byteLength: 12,
      title: 'DPB review pack',
    }));
    const owner = app(UserRole.OWNER, { release }, { pdf });
    const request = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contentHash: 'b'.repeat(64), pdfHash: 'a'.repeat(64) }),
    };
    const denied = await owner.request(`/v1/reports/dpb/${reportId}/release`, request);
    expect(denied.status).toBe(403);
    const founder = app(UserRole.FOUNDER, { release }, { pdf });
    const result = await founder.request(`/v1/reports/dpb/${reportId}/release`, request);
    expect(result.status).toBe(200);
    expect(release).toHaveBeenCalledWith(
      tenantId,
      actorId,
      reportId,
      'b'.repeat(64),
      'a'.repeat(64),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('makes frozen source inspection founder-only', async () => {
    const source = vi.fn(async () => ({ sourceText: '{}', sourceSha256: 'a'.repeat(64) }));
    const owner = app(UserRole.OWNER, { source }, {});
    const denied = await owner.request(`/v1/reports/dpb/requests/${requestId}/source`);
    expect(denied.status).toBe(403);
    const founder = app(UserRole.FOUNDER, { source }, {});
    const result = await founder.request(`/v1/reports/dpb/requests/${requestId}/source`);
    expect(result.status).toBe(200);
    expect(source).toHaveBeenCalledWith(tenantId, actorId, requestId, expect.any(AbortSignal));
  });
});
