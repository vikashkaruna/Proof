import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { pramaanClosureRoutes } from './pramaan-closure.js';
import { abortableResult } from '../test/abortable-result.js';
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

describe('Pramaan Closure HTTP Routes', () => {
  it('enforces RBAC on dossier synthesis — viewer is denied', async () => {
    const engagementId = randomUUID();
    const res = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/engagements/${engagementId}/closure/pramaan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dossierType: 'full_closure',
          title: 'Final Statutory Proof Dossier',
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it('synthesizes a draft closure dossier under Owner/Manager role', async () => {
    const engagementId = randomUUID();

    fixture.db.from = ((table: string) => {
      if (table === 'pramaan_dossiers') {
        return {
          insert: () => abortableResult(Promise.resolve({ error: null })),
        } as never;
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => abortableResult(Promise.resolve({ data: null, error: null })),
          }),
        }),
      } as never;
    }) as never;

    fixture.db.rpc = ((name: string) => {
      if (name === 'append_ledger') {
        return abortableResult(Promise.resolve({ data: { success: true }, error: null }));
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.owner, UserRole.OWNER).request(
      `/v1/engagements/${engagementId}/closure/pramaan`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dossierType: 'board_executive',
          title: 'Board Statutory Closure Dossier',
          metadata: { engagementScope: 'full_audit' },
        }),
      },
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('draft');
    expect(body.dossierType).toBe('board_executive');
    expect(body.title).toBe('Board Statutory Closure Dossier');
    expect(typeof body.merkleRoot).toBe('string');
    expect(body.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof body.proofSealHash).toBe('string');
    expect(body.proofSealHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('enforces RBAC on dossier sealing — member without release capability is denied', async () => {
    const dossierId = randomUUID();
    const res = await app(fixture.viewer, UserRole.VIEWER).request(
      `/v1/dossiers/${dossierId}/seal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedProofSeal: 'a'.repeat(64),
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it('seals a dossier under Founder Authority', async () => {
    const dossierId = randomUUID();
    const proofSeal = 'b'.repeat(64);

    fixture.db.rpc = ((name: string) => {
      if (name === 'seal_pramaan_dossier') {
        return abortableResult(
          Promise.resolve({
            data: {
              dossierId,
              status: 'sealed',
              sealedAt: '2026-09-28T12:00:00.000Z',
            },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.founder, UserRole.FOUNDER).request(
      `/v1/dossiers/${dossierId}/seal`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedProofSeal: proofSeal,
        }),
      },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('sealed');
    expect(body.dossierId).toBe(dossierId);
  });

  it('dispatches report/dossier email and records audit log', async () => {
    const dossierId = randomUUID();
    const dispatchId = randomUUID();

    fixture.db.from = ((table: string) => {
      if (table === 'pramaan_dossiers') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  abortableResult(
                    Promise.resolve({
                      data: {
                        id: dossierId,
                        tenant_id: tenant,
                        engagement_id: randomUUID(),
                        dossier_type: 'full_closure',
                        title: 'Statutory Proof Dossier',
                        status: 'sealed',
                        merkle_root: 'c'.repeat(64),
                        manifest_hash: 'd'.repeat(64),
                        proof_seal_hash: 'e'.repeat(64),
                        metadata: {},
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                      },
                      error: null,
                    }),
                  ),
              }),
            }),
          }),
        } as never;
      }
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => abortableResult(Promise.resolve({ data: null, error: null })),
          }),
        }),
      } as never;
    }) as never;

    fixture.db.rpc = ((name: string) => {
      if (name === 'record_report_email_dispatch') {
        return abortableResult(
          Promise.resolve({
            data: { dispatchId, status: 'sent' },
            error: null,
          }),
        );
      }
      return abortableResult(Promise.resolve({ data: null, error: null }));
    }) as never;

    const res = await app(fixture.owner, UserRole.OWNER).request('/v1/reports/email/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        recipientEmail: 'dpo@client.com',
        dossierId,
        notes: 'Approved by board on 28-Sep-2026',
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('simulated');
    expect(body.dispatchId).toBe(dispatchId);
  });
});
