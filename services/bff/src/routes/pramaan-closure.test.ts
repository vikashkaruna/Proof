import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { pramaanClosureRoutes } from './pramaan-closure.js';
import { packFixture } from '../test/evidence-pack-fixture.js';
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

  it('denies a viewer and refuses unsupported dossier types before any mutating RPC', async () => {
    const engagementId = randomUUID();
    const body = JSON.stringify({
      dossierType: 'full_closure',
      title: 'Source-free dossier',
      reportId: randomUUID(),
      operationKey: randomUUID(),
    });
    fixture.db.rpc = (() => {
      throw new Error('unsupported synthesis tried a mutating RPC');
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
      'source_bound_dossier_required',
    );
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
});
