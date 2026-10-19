import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { pramaanClosureRoutes } from './pramaan-closure.js';
import { packFixture } from '../test/evidence-pack-fixture.js';
import { abortableResult } from '../test/abortable-result.js';
import { tenant } from '../test/evidence-fixture.js';
import type { Variables } from '../types.js';

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
  instance.route('/v1', pramaanClosureRoutes({ db: fixture.db }));
  return instance;
}

function preventPersistence() {
  fixture.db.from = (() => {
    throw new Error('closed endpoint tried to access persistence');
  }) as never;
  fixture.db.rpc = (() => {
    throw new Error('closed endpoint tried to call a mutating RPC');
  }) as never;
}

function historicalDossier() {
  const id = randomUUID();
  fixture.base.rows('pramaan_dossiers').push({
    id,
    tenant_id: tenant,
    engagement_id: randomUUID(),
    dossier_type: 'full_closure',
    title: 'Historical unverified dossier',
    status: 'sealed',
    merkle_root: 'c'.repeat(64),
    manifest_hash: 'd'.repeat(64),
    proof_seal_hash: 'e'.repeat(64),
    metadata: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return id;
}

describe('Pramaan closure fail-closed HTTP routes', () => {
  it('keeps the DPB creation route tenant-scoped and rejects invented engagement binding', async () => {
    const base = {
      dossierType: 'dpb_statutory',
      title: 'Recorded breach derivative',
      reportId: randomUUID(),
      operationKey: randomUUID(),
    };
    const options = (body: unknown) => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const invented = await app().request(
      '/v1/closure/pramaan/dpb',
      options({ ...base, engagementId: randomUUID() }),
    );
    expect(invented.status).toBe(400);
    const wrongKind = await app().request(
      '/v1/closure/pramaan/dpb',
      options({ ...base, dossierType: 'full_closure' }),
    );
    expect(wrongKind.status).toBe(400);
    const viewer = await app(fixture.viewer, UserRole.VIEWER).request(
      '/v1/closure/pramaan/dpb',
      options(base),
    );
    expect(viewer.status).toBe(403);
  });

  it('denies a viewer and refuses missing authoritative closure sources before mutation', async () => {
    const engagementId = randomUUID();
    const body = JSON.stringify({
      dossierType: 'full_closure',
      title: 'Source-free dossier',
      reportId: randomUUID(),
      operationKey: randomUUID(),
    });
    fixture.db.rpc = ((fn: string) => {
      expect(fn).toBe('read_full_closure_source');
      return abortableResult(
        Promise.resolve({
          data: null,
          error: { code: '23514', message: 'released_board_source_required' },
        }),
      );
    }) as never;
    const viewer = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/engagements/${engagementId}/closure/pramaan`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body },
    );
    expect(viewer.status).toBe(403);
    const manager = await app().request(`/v1/engagements/${engagementId}/closure/pramaan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(manager.status).toBe(409);
    expect(((await manager.json()) as { error: { code: string } }).error.code).toBe(
      'released_board_source_required',
    );
    expect(fixture.base.rows('pramaan_full_builds')).toHaveLength(0);
  });

  it('refuses founder sealing without source and vault receipts before any RPC', async () => {
    fixture.db.rpc = (() => {
      throw new Error('historical sealing tried a mutating RPC');
    }) as never;
    const res = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/dossiers/${randomUUID()}/seal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedProofSeal: 'b'.repeat(64) }),
      },
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'source_bound_dossier_required',
    );
  });

  it('refuses report and dossier email before any external dispatch or audit write', async () => {
    preventPersistence();
    for (const target of [{ reportId: randomUUID() }, { dossierId: randomUUID() }]) {
      const res = await app().request('/v1/reports/email/dispatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ recipientEmail: 'auditor@example.invalid', ...target }),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
        'source_bound_dispatch_required',
      );
    }
  });

  it('limits historical dossier inspection to a live internal tenant founder', async () => {
    const id = historicalDossier();
    const viewer = await app(fixture.viewer, UserRole.VIEWER).request(`/v1/dossiers/${id}`);
    expect(viewer.status).toBe(403);
    const owner = await app().request('/v1/dossiers');
    expect(owner.status).toBe(403);

    const founderList = await app(fixture.founder, UserRole.FOUNDER).request('/v1/dossiers');
    expect(founderList.status).toBe(200);
    expect(founderList.headers.get('cache-control')).toBe('private, no-store');
    expect(((await founderList.json()) as { dossiers: unknown[] }).dossiers).toHaveLength(1);
    const founderDetail = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/dossiers/${id}`,
    );
    expect(founderDetail.status).toBe(200);
    expect(founderDetail.headers.get('cache-control')).toBe('private, no-store');

    const membership = fixture.base
      .rows('tenant_users')
      .find((row) => row.tenant_id === tenant && row.user_id === fixture.founder)!;
    membership.role = UserRole.VIEWER;
    const revoked = await app(fixture.founder, UserRole.FOUNDER).request(`/v1/dossiers/${id}`);
    expect(revoked.status).toBe(404);
  });

  it('lists only sealed dossiers, read-only and without sealer identity, to a member viewer', async () => {
    const hiddenFull = historicalDossier();
    const sealed = randomUUID();
    fixture.base.rows('pramaan_dossiers').push({
      ...fixture.base.rows('pramaan_dossiers')[0]!,
      id: sealed,
      dossier_type: 'board_executive',
    });
    fixture.db.rpc = ((fn: string) => {
      expect(fn).toBe('read_sealed_dossier_summaries');
      const rows = fixture.base
        .rows('pramaan_dossiers')
        .filter((row) => row.status === 'sealed' && row.id !== hiddenFull)
        .map((row) => ({ ...row, sealed_at: null }));
      return abortableResult(Promise.resolve({ data: { rows, total: rows.length }, error: null }));
    }) as never;
    fixture.base.rows('pramaan_dossiers').push({
      id: randomUUID(),
      tenant_id: tenant,
      engagement_id: randomUUID(),
      dossier_type: 'board_executive',
      title: 'Unsealed draft',
      status: 'draft',
      merkle_root: 'f'.repeat(64),
      manifest_hash: 'a'.repeat(64),
      proof_seal_hash: 'b'.repeat(64),
      metadata: { private: true },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const response = await app(fixture.viewer, UserRole.VIEWER).request('/v1/dossiers/sealed');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as { dossiers: Record<string, unknown>[] };
    expect(body.dossiers.map((d) => d.id)).toEqual([sealed]);
    expect(body.dossiers[0]).not.toHaveProperty('sealedBy');
    expect(body.dossiers[0]).not.toHaveProperty('metadata');

    // Detail and archive stay closed to the viewer.
    expect(
      (await app(fixture.viewer, UserRole.VIEWER).request(`/v1/dossiers/${sealed}`)).status,
    ).toBe(403);
    expect(
      (await app(fixture.viewer, UserRole.VIEWER).request(`/v1/dossiers/${sealed}/archive`)).status,
    ).toBe(403);
  });

  it('refuses the sealed list to someone who is not a member of the tenant', async () => {
    historicalDossier();
    const outsider = await app(randomUUID(), UserRole.VIEWER).request('/v1/dossiers/sealed');
    expect(outsider.status).toBe(403);
  });
});

describe('full closure review and release HTTP boundary', () => {
  it.each(['review', 'release'])(
    'requires founder authority and strict exact-version payload for %s',
    async (action) => {
      const id = randomUUID(),
        body = {
          expectedArchiveSha256: 'a'.repeat(64),
          expectedVersionId: 'exact-version',
          ...(action === 'review' ? { note: 'Reviewed exact archive' } : {}),
        };
      for (const [user, role] of [
        [fixture.owner, UserRole.OWNER],
        [fixture.viewer, UserRole.VIEWER],
      ] as const) {
        const denied = await app(user, role).request(`/v1/dossiers/${id}/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(denied.status).toBe(403);
      }
      const invalid = await app(fixture.founder, UserRole.FOUNDER).request(
        `/v1/dossiers/${id}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, arbitrary: true }),
        },
      );
      expect(invalid.status).toBe(400);
      const missing = await app(fixture.founder, UserRole.FOUNDER).request(
        `/v1/dossiers/${id}/${action}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      expect(missing.status).toBe(409);
      expect(fixture.base.rows('pramaan_full_reviews')).toHaveLength(0);
      expect(fixture.base.rows('pramaan_full_releases')).toHaveLength(0);
    },
  );
  it('refuses review archive previews to viewers and missing retained archives to founders', async () => {
    const path = `/v1/dossiers/${randomUUID()}/archive/preview`;
    expect((await app(fixture.viewer, UserRole.VIEWER).request(path)).status).toBe(403);
    const absent = await app(fixture.founder, UserRole.FOUNDER).request(path);
    expect(absent.status).toBe(409);
    expect(absent.headers.get('cache-control')).toBe('private, no-store');
  });
});
