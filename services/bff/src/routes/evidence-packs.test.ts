import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { evidencePackRoutes } from './evidence-packs.js';
import { reportAuthority } from '../middleware/report-authority.js';
import { packFixture } from '../test/evidence-pack-fixture.js';
import { tenant, foreign } from '../test/evidence-fixture.js';
import type { Variables } from '../types.js';

async function payload(response: Response) {
  return (await response.json()) as {
    data: {
      archive_sha256: string;
      archive: { contentHash: string };
      build: { errorCode: string };
    };
    meta: { total: number };
    error: { code: string };
  };
}
let fixture: Awaited<ReturnType<typeof packFixture>>;
beforeEach(async () => {
  fixture = await packFixture();
});
function app(user = fixture.owner, role: UserRole = UserRole.OWNER, tenantId = tenant) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('user', { id: user } as never);
    c.set('role', role);
    c.set('tenantId', tenantId);
    await next();
  });
  instance.route('/v1', evidencePackRoutes({ db: fixture.db, service: fixture.service }));
  return instance;
}
function post(path: string, body: unknown, user = fixture.owner, role: UserRole = UserRole.OWNER) {
  return app(user, role).request(`/v1${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
describe('report and pack HTTP contracts', () => {
  it('paginates tenant engagement options and exposes only the public selection fields', async () => {
    const first = randomUUID();
    const second = randomUUID();
    fixture.base.rows('engagements').push(
      {
        id: first,
        tenant_id: tenant,
        title: 'Alpha',
        library_version: '0.1.1',
        private_note: 'secret',
      },
      { id: second, tenant_id: tenant, title: 'Beta', library_version: '0.1.0' },
      { id: randomUUID(), tenant_id: foreign, title: 'Foreign', library_version: '0.1.1' },
    );
    fixture.base
      .rows('control_libraries')
      .push({ version: '0.1.1', is_current: true }, { version: '0.1.0', is_current: false });
    const response = await app().request('/v1/evidence-packs/options/engagements?limit=1');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{ id: first, title: 'Alpha', libraryVersion: '0.1.1' }],
      meta: { limit: 1, offset: 0, total: 2, hasMore: true },
      currentLibraryVersion: '0.1.1',
    });
    const next = await app().request('/v1/evidence-packs/options/engagements?limit=1&offset=1');
    expect(await next.json()).toEqual({
      data: [{ id: second, title: 'Beta', libraryVersion: '0.1.0' }],
      meta: { limit: 1, offset: 1, total: 2, hasMore: false },
      currentLibraryVersion: '0.1.1',
    });
  });
  it('honestly returns empty engagement options and an absent current library', async () => {
    const response = await app().request('/v1/evidence-packs/options/engagements');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      meta: { limit: 20, offset: 0, total: 0, hasMore: false },
      currentLibraryVersion: null,
    });
  });
  it('refuses engagement options to viewers, foreign tenants and stale manager membership', async () => {
    const path = '/v1/evidence-packs/options/engagements';
    expect((await app(fixture.viewer, UserRole.VIEWER).request(path)).status).toBe(403);
    expect((await app(fixture.owner, UserRole.OWNER, foreign).request(path)).status).toBe(403);
    fixture.base.rows('tenant_users').find((row) => row.user_id === fixture.owner)!.role = 'viewer';
    expect((await app().request(path)).status).toBe(403);
  });
  it('validates engagement pagination and rejects unsupported options', async () => {
    for (const query of [
      'limit=0',
      'limit=51',
      'limit=1.5',
      'offset=-1',
      'offset=1000001',
      'status=draft',
      'tenantId=foreign',
    ]) {
      expect((await app().request(`/v1/evidence-packs/options/engagements?${query}`)).status).toBe(
        400,
      );
    }
  });
  it('refuses unavailable, malformed or ambiguous engagement metadata without leaking diagnostics', async () => {
    const path = '/v1/evidence-packs/options/engagements';
    fixture.base.faults.read = true;
    const response = await app().request(path);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('sensitive');
    fixture.base
      .rows('control_libraries')
      .push({ version: '0.1.0', is_current: true }, { version: '0.1.1', is_current: true });
    expect((await app().request(path)).status).toBe(503);
    fixture.base.rows('control_libraries').splice(0);
    fixture.base
      .rows('engagements')
      .push({ id: 'invalid', tenant_id: tenant, title: 'Broken', library_version: '0.1.1' });
    expect((await app().request(path)).status).toBe(503);
  });
  it('returns actual empty pages and explicit database errors', async () => {
    const empty = await app().request('/v1/reports');
    expect(empty.status).toBe(200);
    expect(await payload(empty)).toEqual({
      data: [],
      meta: { total: 0, limit: 25, offset: 0, hasMore: false },
    });
    fixture.base.faults.read = true;
    const unavailable = await app().request('/v1/reports');
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await payload(unavailable))).not.toContain('sensitive');
  });
  it('prepares only bounded server-resolved receipt selections and exposes no storage endpoints', async () => {
    const prepared = await post('/evidence-packs', fixture.input);
    expect(prepared.status).toBe(201);
    const body = await payload(prepared);
    expect(body.data).toMatchObject({
      title: fixture.input.title,
      status: 'draft',
      manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      archive: null,
    });
    expect(JSON.stringify(body)).not.toContain('fixture-evidence');
    for (const extra of [
      { storageUri: 'https://example.invalid' },
      { libraryVersion: 'caller-version' },
      { manifestText: '{}' },
    ]) {
      expect((await post('/evidence-packs', { ...fixture.input, ...extra })).status).toBe(400);
    }
    expect(
      (await post('/evidence-packs', { ...fixture.input, evidenceReceiptIds: [] })).status,
    ).toBe(400);
  });
  it('lists only own manager drafts; internal founder sees all and viewer sees published only', async () => {
    const pack = await fixture.prepare();
    const another = randomUUID();
    fixture.base.rows('tenant_users').push({ tenant_id: tenant, user_id: another, role: 'admin' });
    for (const [user, role, count] of [
      [fixture.owner, UserRole.OWNER, 1],
      [another, UserRole.ADMIN, 0],
      [fixture.founder, UserRole.FOUNDER, 1],
      [fixture.viewer, UserRole.VIEWER, 0],
    ] as const) {
      const response = await app(user, role).request('/v1/reports');
      expect(response.status).toBe(200);
      expect((await payload(response)).meta.total).toBe(count);
    }
    expect(
      (await app(another, UserRole.ADMIN).request(`/v1/evidence-packs/${pack.pack.id}`)).status,
    ).toBe(404);
    expect(
      (await app(fixture.owner, UserRole.OWNER, foreign).request(`/v1/reports/${pack.report.id}`))
        .status,
    ).toBe(403);
  });
  it('rechecks membership instead of trusting an earlier manager role snapshot', async () => {
    const pack = await fixture.prepare();
    fixture.base.rows('tenant_users').find((r) => r.user_id === fixture.owner)!.role = 'viewer';
    expect((await app().request(`/v1/reports/${pack.report.id}`)).status).toBe(404);
    expect((await post('/evidence-packs', fixture.input)).status).toBe(403);
  });
  it.each([UserRole.OWNER, UserRole.ADMIN, UserRole.AXIOM_ANALYST, UserRole.VIEWER])(
    'refuses report review/release to %s',
    async (role) => {
      const id = randomUUID();
      const body = { expectedContentHash: 'a'.repeat(64) };
      expect(
        (
          await post(
            `/reports/${id}/review`,
            { ...body, decision: 'approved' },
            fixture.owner,
            role,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(
            `/reports/${id}/release`,
            { ...body, expectedArchiveHash: null },
            fixture.owner,
            role,
          )
        ).status,
      ).toBe(403);
      expect(fixture.calls).toHaveLength(0);
    },
  );
  it('requires the founder internal fact and expected immutable digest', async () => {
    const pack = await fixture.prepare();
    const path = `/reports/${pack.report.id}/review`;
    expect(
      (await post(path, { decision: 'approved' }, fixture.founder, UserRole.FOUNDER)).status,
    ).toBe(400);
    const stale = await post(
      path,
      { decision: 'approved', expectedContentHash: 'b'.repeat(64) },
      fixture.founder,
      UserRole.FOUNDER,
    );
    expect(stale.status).toBe(409);
    expect((await payload(stale)).error.code).toBe('manifest_changed');
    fixture.base.rows('users').find((u) => u.id === fixture.founder)!.is_axiom_internal = false;
    expect(
      (
        await post(
          path,
          { decision: 'approved', expectedContentHash: pack.pack.manifest_sha256 },
          fixture.founder,
          UserRole.FOUNDER,
        )
      ).status,
    ).toBe(403);
  });
  it('builds, releases a digest pair, and exports actual stored archive bytes', async () => {
    const pack = await fixture.prepare();
    const review = await post(
      `/reports/${pack.report.id}/review`,
      { decision: 'approved', expectedContentHash: pack.pack.manifest_sha256 },
      fixture.founder,
      UserRole.FOUNDER,
    );
    expect(review.status).toBe(200);
    const built = await post(`/evidence-packs/${pack.pack.id}/build`, {
      operationKey: randomUUID(),
    });
    expect(built.status).toBe(200);
    const archive = (await payload(built)).data.archive;
    const path = `/evidence-packs/${pack.pack.id}/content`;
    expect((await app().request(`/v1${path}`)).status).toBe(409);
    const release = await post(
      `/reports/${pack.report.id}/release`,
      { expectedContentHash: pack.pack.manifest_sha256, expectedArchiveHash: archive.contentHash },
      fixture.founder,
      UserRole.FOUNDER,
    );
    expect(release.status).toBe(200);
    const content = await app().request(`/v1${path}`);
    expect(content.status).toBe(200);
    expect(content.headers.get('content-type')).toBe('application/zip');
    expect(content.headers.get('x-evidence-sha256')).toBe(archive.contentHash);
    expect(Buffer.from(await content.arrayBuffer()).equals(fixture.storedArchive()!)).toBe(true);
    expect((await app(fixture.viewer, UserRole.VIEWER).request(`/v1${path}`)).status).toBe(403);
    const released = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/reports/${pack.report.id}`,
    );
    expect(released.status).toBe(200);
    const sidecar = await app().request(`/v1/evidence-packs/${pack.pack.id}/release-receipt`);
    expect(sidecar.status).toBe(200);
    expect((await payload(sidecar)).data.archive_sha256).toBe(archive.contentHash);
  });
  it('keeps uncertain builds explicitly pending and read-only reconciliation honest', async () => {
    const pack = await fixture.approve();
    const key = randomUUID();
    fixture.base.vault.seal.mockRejectedValue(new Error('secret signed URL'));
    const response = await post(`/evidence-packs/${pack.pack.id}/build`, { operationKey: key });
    expect(response.status).toBe(202);
    expect((await payload(response)).data.build).toMatchObject({
      status: 'pending',
      errorCode: 'storage_or_settlement_unconfirmed',
    });
    fixture.base.vault.findEvidenceVersion.mockResolvedValue(null);
    const reconciled = await post(`/evidence-packs/${pack.pack.id}/builds/${key}/reconcile`, {});
    expect(reconciled.status).toBe(202);
    expect((await payload(reconciled)).data.build.errorCode).toBe('object_version_not_found');
    expect(fixture.base.vault.seal).toHaveBeenCalledOnce();
  });
  it('preserves legacy null assurance and refuses a fabricated downloadable artifact', async () => {
    const id = randomUUID();
    fixture.base.rows('reports').push({
      id,
      tenant_id: tenant,
      engagement_id: null,
      kind: 'board',
      title: 'Historical report',
      library_version: '0.1.1',
      generated_by_agent: 'legacy',
      generated_at: '2026-09-27T00:00:00.000Z',
      created_by: null,
      status: 'published',
      content: { historical: true },
      content_text: null,
      content_sha256: null,
      reviewed_content_hash: null,
      published_at: '2026-09-27T00:00:00.000Z',
      released_by: null,
      released_archive_hash: null,
    });
    const result = await app().request(`/v1/reports/${id}`);
    expect(result.status).toBe(200);
    expect((await payload(result)).data).toMatchObject({
      content: { historical: true },
      contentText: null,
      contentHash: null,
      assurance: 'legacy_unverified',
      pack: null,
    });
    expect((await app().request(`/v1/reports/${id}/content`)).status).toBe(409);
  });
});

describe('report authority before cached replay', () => {
  it('blocks cached review and other-owner build responses after internal authority is revoked', async () => {
    const pack = await fixture.prepare();
    const instance = new Hono<{ Variables: Variables }>();
    let cacheReached = false;
    instance.use('*', async (c, next) => {
      c.set('user', { id: fixture.founder } as never);
      c.set('tenantId', tenant);
      c.set('role', UserRole.FOUNDER);
      await next();
    });
    instance.use('/v1/*', reportAuthority(fixture.db));
    instance.post('/v1/*', (c) => {
      cacheReached = true;
      return c.json({ cached: true });
    });
    fixture.base.rows('users').find((u) => u.id === fixture.founder)!.is_axiom_internal = false;
    expect(
      (await instance.request(`/v1/reports/${pack.report.id}/review`, { method: 'POST' })).status,
    ).toBe(403);
    expect(
      (await instance.request(`/v1/evidence-packs/${pack.pack.id}/build`, { method: 'POST' }))
        .status,
    ).toBe(404);
    expect(cacheReached).toBe(false);
  });
});
