import { beforeEach, describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { UserRole } from '@axiom/types';
import { randomUUID } from 'node:crypto';
import { w2ParityRoutes } from './w2-parity.js';
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
  instance.route('/v1', w2ParityRoutes({ db: fixture.db }));
  return instance;
}

describe('W2 Parity HTTP Routes (ROPA, Policies, Playbooks, Classification)', () => {
  // ─── 1. ROPA Records ──────────────────────────────────────────────────
  describe('ROPA Records', () => {
    it('denies viewer from creating ROPA record with 403', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/ropa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purposeName: 'Customer Support',
          legalBasis: 'consent',
          dataCategories: ['contact_info'],
          dataPrincipals: ['customers'],
          retentionPeriodMonths: 24,
          securityMeasures: 'AES-256 encryption at rest',
        }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects invalid ROPA payload with 400', async () => {
      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/ropa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purposeName: '',
          legalBasis: 'invalid_basis',
          dataCategories: [],
          dataPrincipals: [],
          retentionPeriodMonths: -5,
          securityMeasures: '',
        }),
      });
      expect(res.status).toBe(400);
    });

    it('allows owner to create ROPA record and returns 201', async () => {
      const oldRpc = fixture.db.rpc;
      const expectedRecordId = randomUUID();
      fixture.db.rpc = ((fn: string, args: Record<string, unknown>) => {
        if (fn === 'create_ropa_record') {
          return {
            abortSignal: () =>
              Promise.resolve({
                data: {
                  recordId: expectedRecordId,
                  status: 'active',
                  purposeName: args.p_purpose_name,
                  version: 1,
                },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: {
                  recordId: expectedRecordId,
                  status: 'active',
                  purposeName: args.p_purpose_name,
                  version: 1,
                },
                error: null,
              }),
          };
        }
        return oldRpc(fn, args);
      }) as never;

      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/ropa', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          purposeName: 'Customer Onboarding & KYC',
          legalBasis: 'statutory',
          dataCategories: ['identity_proof', 'address_proof'],
          dataPrincipals: ['individuals'],
          recipients: ['verification_vendor'],
          crossBorderTransfers: true,
          destinationCountries: ['SG'],
          retentionPeriodMonths: 96,
          securityMeasures: 'Client-side envelope encryption with KMS HSM keys',
          dpiaRequired: true,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { recordId: string; status: string };
      expect(json.recordId).toBe(expectedRecordId);
      expect(json.status).toBe('active');
    });

    it('allows authenticated viewer to list ROPA records with 200', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/ropa', {
        method: 'GET',
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { records: unknown[] };
      expect(Array.isArray(json.records)).toBe(true);
    });
  });

  // ─── 2. Policy Drafts ─────────────────────────────────────────────────
  describe('Policy Drafts', () => {
    it('denies viewer from creating policy draft with 403', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/policies/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Encryption Policy',
          category: 'data_protection',
          summary: 'Baseline encryption requirements',
          content: 'Mandates AES-256 for all stored data.',
        }),
      });
      expect(res.status).toBe(403);
    });

    it('creates policy draft for owner with 201', async () => {
      const draftId = randomUUID();
      const oldRpc = fixture.db.rpc;
      fixture.db.rpc = ((fn: string, args: Record<string, unknown>) => {
        if (fn === 'create_policy_draft') {
          return {
            abortSignal: () =>
              Promise.resolve({
                data: {
                  draftId,
                  status: 'draft',
                  contentHash: 'a'.repeat(64),
                  version: 1,
                },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: {
                  draftId,
                  status: 'draft',
                  contentHash: 'a'.repeat(64),
                  version: 1,
                },
                error: null,
              }),
          };
        }
        return oldRpc(fn, args);
      }) as never;

      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/policies/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Encryption Policy',
          category: 'data_protection',
          summary: 'Baseline encryption requirements',
          content: 'Mandates AES-256 for all stored data.',
          controlCitations: ['DPDPA-SEC-001'],
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { draftId: string; status: string };
      expect(json.draftId).toBe(draftId);
      expect(json.status).toBe('draft');
    });

    it('denies viewer from reviewing policy draft with 403', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request(
        `/v1/policies/drafts/${randomUUID()}/review`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision: 'approved',
            expectedHash: 'a'.repeat(64),
          }),
        },
      );
      expect(res.status).toBe(403);
    });

    it('allows founder to review policy draft and returns 200', async () => {
      const draftId = randomUUID();
      const oldRpc = fixture.db.rpc;
      fixture.db.rpc = ((fn: string, _args: Record<string, unknown>) => {
        if (fn === 'review_policy_draft') {
          return {
            abortSignal: () =>
              Promise.resolve({
                data: {
                  draftId,
                  status: 'approved',
                  reviewedAt: new Date().toISOString(),
                },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: {
                  draftId,
                  status: 'approved',
                  reviewedAt: new Date().toISOString(),
                },
                error: null,
              }),
          };
        }
        return oldRpc(fn, _args);
      }) as never;

      const res = await app(fixture.founder, UserRole.FOUNDER).request(
        `/v1/policies/drafts/${draftId}/review`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            decision: 'approved',
            expectedHash: 'a'.repeat(64),
          }),
        },
      );

      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('approved');
    });
  });

  // ─── 3. Playbook Entries ──────────────────────────────────────────────
  describe('Playbook Entries', () => {
    it('denies viewer from creating playbook entry with 403', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/playbooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Critical Breach Protocol',
          kind: 'incident_response',
          triggerCondition: 'Critical severity breach detected',
          targetAgent: 'nazar',
          steps: [{ step: 1, action: 'quarantine' }],
        }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects invalid agent in playbook entry with 400', async () => {
      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/playbooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Critical Breach Protocol',
          kind: 'incident_response',
          triggerCondition: 'Critical severity breach detected',
          targetAgent: 'unauthorized_agent',
          steps: [{ step: 1, action: 'quarantine' }],
        }),
      });
      expect(res.status).toBe(400);
    });

    it('creates playbook entry for owner with 201', async () => {
      const playbookId = randomUUID();
      const oldRpc = fixture.db.rpc;
      fixture.db.rpc = ((fn: string, args: Record<string, unknown>) => {
        if (fn === 'create_playbook_entry') {
          return {
            abortSignal: () =>
              Promise.resolve({
                data: {
                  playbookId,
                  status: 'active',
                  title: args.p_title,
                  version: 1,
                },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: {
                  playbookId,
                  status: 'active',
                  title: args.p_title,
                  version: 1,
                },
                error: null,
              }),
          };
        }
        return oldRpc(fn, args);
      }) as never;

      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/playbooks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Critical Breach Protocol',
          kind: 'incident_response',
          triggerCondition: 'Critical severity breach detected',
          targetAgent: 'nazar',
          steps: [{ step: 1, action: 'quarantine' }],
          requiresHumanApproval: true,
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { playbookId: string; status: string };
      expect(json.playbookId).toBe(playbookId);
      expect(json.status).toBe('active');
    });
  });

  // ─── 4. Classification Reviews ────────────────────────────────────────
  describe('Classification Reviews', () => {
    it('denies viewer from submitting classification review with 403', async () => {
      const res = await app(fixture.viewer, UserRole.VIEWER).request('/v1/classification/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemId: 'prod-aurora-db',
          resourcePath: 'customers.aadhar_vault',
          sensitivityLevel: 'critical_pii',
          detectedCategories: ['national_id'],
          confidenceScore: 95.0,
          decision: 'confirmed',
          justification: 'Reviewed and confirmed',
        }),
      });
      expect(res.status).toBe(403);
    });

    it('submits classification review for owner with 201', async () => {
      const reviewId = randomUUID();
      const oldRpc = fixture.db.rpc;
      fixture.db.rpc = ((fn: string, _args: Record<string, unknown>) => {
        if (fn === 'submit_classification_review') {
          return {
            abortSignal: () =>
              Promise.resolve({
                data: {
                  reviewId,
                  decision: 'confirmed',
                  finalSensitivity: 'critical_pii',
                },
                error: null,
              }),
            then: (resolve: (v: unknown) => unknown) =>
              resolve({
                data: {
                  reviewId,
                  decision: 'confirmed',
                  finalSensitivity: 'critical_pii',
                },
                error: null,
              }),
          };
        }
        return oldRpc(fn, _args);
      }) as never;

      const res = await app(fixture.owner, UserRole.OWNER).request('/v1/classification/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemId: 'prod-aurora-db',
          resourcePath: 'customers.aadhar_vault',
          sensitivityLevel: 'critical_pii',
          detectedCategories: ['national_id'],
          confidenceScore: 95.0,
          decision: 'confirmed',
          justification: 'Reviewed and confirmed',
        }),
      });

      expect(res.status).toBe(201);
      const json = (await res.json()) as { reviewId: string; finalSensitivity: string };
      expect(json.reviewId).toBe(reviewId);
      expect(json.finalSensitivity).toBe('critical_pii');
    });
  });
});
