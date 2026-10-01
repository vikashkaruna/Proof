import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { UserRole } from '@axiom/types';
import { approvalProofArchiveRoutes } from './approval-proof-archive.js';
import { EvidenceError } from '../services/evidence-ingestion.js';
import type { Variables } from '../types.js';

const tenantId = randomUUID();
const actorId = randomUUID();
const id = randomUUID();
const operationKey = randomUUID();
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function app(role: UserRole, service: Record<string, unknown>) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('user', { id: actorId } as never);
    c.set('role', role);
    await next();
  });
  instance.route(
    '/v1',
    approvalProofArchiveRoutes({ approvalEngine: {} as never, service: service as never }),
  );
  return instance;
}

describe('approval proof archive routes', () => {
  it('refuses every archive route to a role without evidence export, touching no service', async () => {
    const service = {
      start: vi.fn(),
      statusForToken: vi.fn(),
      status: vi.fn(),
      reconcile: vi.fn(),
      retryMissing: vi.fn(),
      release: vi.fn(),
      preview: vi.fn(),
      review: vi.fn(),
      download: vi.fn(),
    };
    const viewer = app(UserRole.VIEWER, service);
    const calls: Array<[string, RequestInit?]> = [
      [`/v1/approvals/${id}/archive`, post({ operationKey })],
      [`/v1/approvals/${id}/archive`],
      [`/v1/approval-archives/${id}`],
      [`/v1/approval-archives/${id}/reconcile`, post({})],
      [`/v1/approval-archives/${id}/retry-missing`, post({})],
      [`/v1/approval-archives/${id}/release`, post({})],
      [`/v1/approval-archives/${id}/preview`],
      [
        `/v1/approval-archives/${id}/review`,
        post({ sourceSha256: 'a'.repeat(64), versionId: 'v1' }),
      ],
      [`/v1/approval-archives/${id}/download`],
    ];
    for (const [path, init] of calls) {
      expect((await viewer.request(path, init)).status, path).toBe(403);
    }
    for (const fn of Object.values(service)) expect(fn).not.toHaveBeenCalled();
  });

  it('starts an archive only for a UUID token and operation key, answering 202 until settled', async () => {
    const start = vi
      .fn()
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'settled' });
    const founder = app(UserRole.FOUNDER, { start });
    const first = await founder.request(`/v1/approvals/${id}/archive`, post({ operationKey }));
    expect(first.status).toBe(202);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(start).toHaveBeenCalledWith(
      tenantId,
      actorId,
      id,
      operationKey,
      expect.any(AbortSignal),
    );
    expect(
      (await founder.request(`/v1/approvals/${id}/archive`, post({ operationKey }))).status,
    ).toBe(200);
    for (const body of [{}, { operationKey: 'x' }, { operationKey, caller: 'claim' }, null]) {
      expect(
        (await founder.request(`/v1/approvals/${id}/archive`, post(body))).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(
      (await founder.request('/v1/approvals/not-a-uuid/archive', post({ operationKey }))).status,
    ).toBe(400);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('reads status by token and by archive id, validating ids', async () => {
    const statusForToken = vi.fn(async () => ({ status: 'none' }));
    const status = vi.fn(async () => ({ status: 'sealed' }));
    const founder = app(UserRole.FOUNDER, { statusForToken, status });
    expect((await founder.request(`/v1/approvals/${id}/archive`)).status).toBe(200);
    expect((await founder.request(`/v1/approval-archives/${id}`)).status).toBe(200);
    expect((await founder.request('/v1/approvals/zzz/archive')).status).toBe(400);
    expect((await founder.request('/v1/approval-archives/zzz')).status).toBe(400);
    expect(statusForToken).toHaveBeenCalledWith(tenantId, actorId, id, expect.any(AbortSignal));
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('reconcile and retry-missing answer 202 while pending and 200 once settled', async () => {
    const reconcile = vi.fn(async () => ({ status: 'pending' }));
    const retryMissing = vi.fn(async () => ({ status: 'settled' }));
    const founder = app(UserRole.FOUNDER, { reconcile, retryMissing });
    expect((await founder.request(`/v1/approval-archives/${id}/reconcile`, post({}))).status).toBe(
      202,
    );
    expect(
      (await founder.request(`/v1/approval-archives/${id}/retry-missing`, post({}))).status,
    ).toBe(200);
    expect((await founder.request('/v1/approval-archives/q/reconcile', post({}))).status).toBe(400);
    expect((await founder.request('/v1/approval-archives/q/retry-missing', post({}))).status).toBe(
      400,
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(retryMissing).toHaveBeenCalledTimes(1);
  });

  it('review requires the exact source hash and version id and passes them through unchanged', async () => {
    const review = vi.fn(async () => ({ status: 'reviewed' }));
    const founder = app(UserRole.FOUNDER, { review });
    const good = { sourceSha256: 'c'.repeat(64), versionId: 'v-42' };
    expect((await founder.request(`/v1/approval-archives/${id}/review`, post(good))).status).toBe(
      200,
    );
    expect(review).toHaveBeenCalledWith(
      tenantId,
      actorId,
      id,
      good.sourceSha256,
      good.versionId,
      expect.any(AbortSignal),
    );
    for (const body of [
      { ...good, sourceSha256: 'C'.repeat(64) },
      { ...good, versionId: '' },
      { sourceSha256: good.sourceSha256 },
      { ...good, extra: true },
    ]) {
      expect(
        (await founder.request(`/v1/approval-archives/${id}/review`, post(body))).status,
        JSON.stringify(body),
      ).toBe(400);
    }
    expect(review).toHaveBeenCalledTimes(1);
  });

  it('release and preview are no-store reads of the service result', async () => {
    const release = vi.fn(async () => ({ released: true }));
    const preview = vi.fn(async () => ({ preview: 'x' }));
    const founder = app(UserRole.FOUNDER, { release, preview });
    const released = await founder.request(`/v1/approval-archives/${id}/release`, post({}));
    expect(released.status).toBe(200);
    expect(released.headers.get('cache-control')).toBe('private, no-store');
    expect((await founder.request(`/v1/approval-archives/${id}/preview`)).status).toBe(200);
    expect((await founder.request('/v1/approval-archives/n/release', post({}))).status).toBe(400);
    expect((await founder.request('/v1/approval-archives/n/preview')).status).toBe(400);
  });

  it('downloads retained bytes with integrity headers and rejects bad ids', async () => {
    const bytes = Buffer.from('{"proof":true}');
    const download = vi.fn(async () => ({ bytes, sha256: 'd'.repeat(64), versionId: 'ver-9' }));
    const founder = app(UserRole.FOUNDER, { download });
    const res = await founder.request(`/v1/approval-archives/${id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-archive-sha256')).toBe('d'.repeat(64));
    expect(res.headers.get('x-archive-version-id')).toBe('ver-9');
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="approval-proof-${id}.json"`,
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await founder.request('/v1/approval-archives/n/download')).status).toBe(400);
  });

  it('maps typed evidence errors to their status and everything else to an opaque 503', async () => {
    const download = vi
      .fn()
      .mockRejectedValueOnce(new EvidenceError('archive_not_sealed', 409))
      .mockRejectedValueOnce(new Error('s3 bucket axiom-secret-bucket unreachable'));
    const founder = app(UserRole.FOUNDER, { download });
    const typed = await founder.request(`/v1/approval-archives/${id}/download`);
    expect(typed.status).toBe(409);
    expect(await typed.json()).toEqual({ error: { code: 'archive_not_sealed' } });
    const opaque = await founder.request(`/v1/approval-archives/${id}/download`);
    expect(opaque.status).toBe(503);
    const text = await opaque.text();
    expect(text).toBe(JSON.stringify({ error: { code: 'approval_archive_unavailable' } }));
    expect(text).not.toContain('axiom-secret-bucket');
  });
});
