import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { evidenceRoutes } from './evidence.js';
import { EvidenceIngestionService } from '../services/evidence-ingestion.js';
import {
  evidenceFixture,
  tenant,
  foreign,
  actor,
  upload,
  config,
  dataBody,
} from '../test/evidence-fixture.js';
import type { Variables } from '../types.js';

let fixture: ReturnType<typeof evidenceFixture>;
let service: EvidenceIngestionService;
beforeEach(() => {
  fixture = evidenceFixture();
  service = new EvidenceIngestionService(fixture.db, fixture.vault, config);
});
function app(role: UserRole = UserRole.ADMIN, tenantId = tenant) {
  const instance = new Hono<{ Variables: Variables }>();
  instance.use('*', async (c, next) => {
    c.set('tenantId', tenantId);
    c.set('user', { id: actor } as never);
    c.set('role', role);
    await next();
  });
  instance.route('/v1', evidenceRoutes({ db: fixture.db, service }));
  return instance;
}
const post = (path: string, body: unknown, role: UserRole = UserRole.ADMIN) =>
  app(role).request(`/v1/evidence${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
async function seed() {
  return (await service.ingest(tenant, actor, upload)).evidenceId!;
}

describe('tenant evidence explorer and human ingestion routes', () => {
  it.each([
    UserRole.AGENT,
    UserRole.VIEWER,
    UserRole.APPROVER,
    UserRole.AXIOM_ANALYST,
    UserRole.REVIEWER,
  ])(
    'denies ingestion/reconciliation to %s independently of read/export privileges',
    async (role) => {
      expect((await post('/ingestions', upload, role)).status).toBe(403);
      expect((await post(`/ingestions/${upload.operationKey}/reconcile`, {}, role)).status).toBe(
        403,
      );
      expect(fixture.calls).toHaveLength(0);
    },
  );
  it('returns 201 only after settled persistence, otherwise durable202 pending', async () => {
    fixture.vault.seal.mockRejectedValue(new Error('unavailable'));
    const pending = await post('/ingestions', upload);
    expect(pending.status).toBe(202);
    expect(await pending.json()).toMatchObject({
      data: { status: 'pending', operationKey: upload.operationKey, evidenceId: null },
    });
    fixture.vault.findEvidenceVersion.mockResolvedValue({ versionId: 'fixture-version-1' });
    const settled = await post(`/ingestions/${upload.operationKey}/reconcile`, {});
    expect(settled.status).toBe(200);
    expect(await settled.json()).toMatchObject({ data: { status: 'settled' } });
  });
  it('lists real empty state and reports a storage failure distinctly', async () => {
    const res = await app().request('/v1/evidence');
    expect(await res.json()).toEqual({
      data: [],
      meta: { total: 0, limit: 25, offset: 0, hasMore: false },
    });
    fixture.faults.read = true;
    const failed = await app().request('/v1/evidence');
    expect(failed.status).toBe(503);
    expect(await failed.json()).toEqual({ error: { code: 'evidence_storage_unavailable' } });
  });
  it('applies tenant, description, control, source, date and pagination filters with actual totals', async () => {
    await seed();
    const original = fixture.rows('evidence')[0]!;
    original.demonstrates_control_ids = ['CNS-001'];
    for (let i = 1; i <= 3; i++)
      fixture.rows('evidence').push({
        ...original,
        id: crypto.randomUUID(),
        description: `match-${i}`,
        content_hash: 'b'.repeat(64),
      });
    fixture.rows('evidence').push({
      ...original,
      id: crypto.randomUUID(),
      tenant_id: foreign,
      description: 'match-foreign',
    });
    const query =
      '?q=match&source=human&controlId=CNS-001&from=2026-09-27&to=2026-09-27&limit=1&offset=1';
    const res = await app().request(`/v1/evidence${query}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[]; meta: unknown };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.description).not.toBe('match-foreign');
    expect(body.meta).toEqual({ total: 3, limit: 1, offset: 1, hasMore: true });
    expect(await (await app().request('/v1/evidence?q=missing')).json()).toMatchObject({
      data: [],
    });
  });
  it('resolves assessment UUID searches by exact tenant-owned ID rather than description', async () => {
    const id = await seed();
    fixture.rows('evidence').push({
      ...fixture.rows('evidence')[0],
      id: crypto.randomUUID(),
      description: `Reference to ${id}`,
    });
    const response = await app().request(`/v1/evidence?q=${id.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: [{ id }],
      meta: { total: 1, hasMore: false },
    });
    const absent = await app().request(`/v1/evidence?q=${crypto.randomUUID()}`);
    expect(await absent.json()).toMatchObject({ data: [], meta: { total: 0 } });
    const foreignResult = await app(UserRole.ADMIN, foreign).request(`/v1/evidence?q=${id}`);
    expect(await foreignResult.json()).toMatchObject({ data: [], meta: { total: 0 } });
  });
  it('shows retained readback separately from legacy claims and never follows legacy storage URIs', async () => {
    const id = await seed();
    const verified = (await (await app().request(`/v1/evidence/${id}`)).json()) as {
      data: { assurance: string; object_version: { version_id: string } };
    };
    expect(verified.data.assurance).toBe('verified_at_ingest');
    expect(verified.data.object_version.version_id).toBe('fixture-version-1');
    const legacy = {
      ...fixture.rows('evidence')[0],
      id: crypto.randomUUID(),
      content_hash: 'b'.repeat(64),
      storage_uri: 'https://169.254.169.254/',
    };
    fixture.rows('evidence').push(legacy);
    const result = (await (await app().request(`/v1/evidence/${legacy.id}`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(result.data.assurance).toBe('legacy_unverified');
    expect(result.data.object_version).toBeNull();
    expect(result.data.storage_uri).toBeUndefined();
    fixture.vault.verifyReceipt.mockClear();
    expect((await post(`/${legacy.id}/verify`, {})).status).toBe(409);
    expect((await app().request(`/v1/evidence/${legacy.id}/content`)).status).toBe(409);
    expect(fixture.vault.verifyReceipt).not.toHaveBeenCalled();
  });
  it('preserves malformed historical hashes without promoting them or breaking tenant reads', async () => {
    await seed();
    const legacy = {
      ...fixture.rows('evidence')[0],
      id: crypto.randomUUID(),
      content_hash: 'not-a-sha256-'.repeat(5) + 'xxxx',
    };
    fixture.rows('evidence').push(legacy);
    const listed = await app().request('/v1/evidence');
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: legacy.id,
          content_hash: legacy.content_hash,
          assurance: 'legacy_unverified',
          object_version: null,
        }),
      ]),
    });
    expect((await post(`/${legacy.id}/verify`, {})).status).toBe(409);
  });
  it('does not expose another tenant evidence or operation', async () => {
    const id = await seed();
    expect((await app(UserRole.ADMIN, foreign).request(`/v1/evidence/${id}`)).status).toBe(404);
    expect(
      (await app(UserRole.ADMIN, foreign).request(`/v1/evidence/ingestions/${upload.operationKey}`))
        .status,
    ).toBe(404);
  });
  it('verifies provider receipts and downloads only exact bounded authenticated bytes as attachments', async () => {
    const id = await seed();
    const verification = await post(`/${id}/verify`, {});
    expect(verification.status).toBe(200);
    expect(await verification.json()).toMatchObject({
      data: { integrity: 'verified', retention: 'verified', versionId: 'fixture-version-1' },
    });
    const download = await app().request(`/v1/evidence/${id}/content`);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-disposition')).toContain('attachment;');
    expect(download.headers.get('content-type')).toBe('application/octet-stream');
    expect(download.headers.get('cache-control')).toBe('private, no-store');
    expect(Buffer.from(await download.arrayBuffer())).toEqual(dataBody);
    expect(fixture.vault.retrieve).toHaveBeenCalledWith(
      config.bucket,
      expect.stringContaining(upload.operationKey),
      'fixture-version-1',
      expect.objectContaining({ maxBytes: 8388608 }),
    );
  });
  it('does not export to a viewer or downgrade failed retention/hash verification to success', async () => {
    const id = await seed();
    expect((await app(UserRole.VIEWER).request(`/v1/evidence/${id}/content`)).status).toBe(403);
    fixture.vault.verifyReceipt.mockRejectedValue(new Error('credential and signed URL details'));
    const response = await post(`/${id}/verify`, {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'provider_verification_failed' } });
    expect((await app().request(`/v1/evidence/${id}/content`)).status).toBe(503);
  });
  it('rejects tampered receipt/evidence linkage and changed bytes after a verified provider readback', async () => {
    const id = await seed();
    fixture.rows('evidence_object_versions')[0]!.content_hash = 'c'.repeat(64);
    expect((await app().request(`/v1/evidence/${id}`)).status).toBe(503);
    fixture.rows('evidence_object_versions')[0]!.content_hash =
      fixture.rows('evidence')[0]!.content_hash;
    fixture.vault.retrieve.mockResolvedValue({
      body: Buffer.from('wrong'),
      contentHash: 'c'.repeat(64),
      metadata: {},
      contentType: 'text/plain',
      retainUntil: undefined,
      lockMode: undefined,
      versionId: 'fixture-version-1',
      encryption: 'AES256',
    });
    expect((await app().request(`/v1/evidence/${id}/content`)).status).toBe(503);
  });
  it.each([
    '?limit=51',
    '?offset=-1',
    '?from=bad',
    '?from=2026-09-28&to=2026-09-27',
    '?bucket=attacker',
  ])('rejects unsupported query %s', async (query) => {
    expect((await app().request(`/v1/evidence${query}`)).status).toBe(400);
  });
  it('rejects storage URLs, scope injection and malformed resource IDs before provider access', async () => {
    expect(
      (await post('/ingestions', { ...upload, storageUri: 'https://attacker.invalid' })).status,
    ).toBe(400);
    expect((await post('/ingestions', { ...upload, tenantId: foreign })).status).toBe(400);
    expect((await app().request('/v1/evidence/not-an-id')).status).toBe(400);
    expect(fixture.vault.seal).not.toHaveBeenCalled();
  });
});
